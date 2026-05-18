import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface AdministrativeSourceType {
  id: number;
  englishValue: string;
}

@Injectable({
  providedIn: 'root'
})
export class AdministrativeSourceTypeService {
  private apiUrl = '/api/administrative-source-types';

  constructor(private http: HttpClient) {}

  getAll(): Observable<AdministrativeSourceType[]> {
    return this.http.get<AdministrativeSourceType[]>(this.apiUrl);
  }
}